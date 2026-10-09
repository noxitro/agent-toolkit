// Safe git plumbing for the skill scout and the converter (skill2zip.mjs). Upstream repositories are untrusted: they are
// cloned shallow and sparse with symlinks written as plain files, no hook templates, no
// LFS smudge, and nothing inside them is ever executed. Every call passes an argument
// array to git directly (no shell), so paths with spaces and MSYS path conversion are not
// an issue.

import { spawnSync } from 'node:child_process'

/** Config forced on every git call that touches an upstream clone. */
const SAFE_CONFIG = [
  '-c', 'core.symlinks=false',
  '-c', 'core.longpaths=true',
  '-c', 'core.autocrlf=false',
  '-c', 'core.fsmonitor=false',
  '-c', 'protocol.ext.allow=never',
  '-c', 'submodule.recurse=false',
]

// MSYS_NO_PATHCONV / MSYS2_ARG_CONV_EXCL are deliberately not set: git.exe is spawned
// directly (no MSYS shell converts our arguments), and setting them breaks Git for
// Windows' own file:// transport, which relies on that conversion internally (measured
// with Git for Windows 2.53: "'/C:/...' does not appear to be a git repository").
export const GIT_ENV = {
  GIT_LFS_SKIP_SMUDGE: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: '',
  SSH_ASKPASS: '',
  LC_ALL: 'C',
}

export class GitError extends Error {}

/**
 * Run git with SAFE_CONFIG. Returns stdout (string, or Buffer with { raw: true }).
 * Throws GitError with stderr on a non-zero exit unless { allowFail: true }.
 */
export function git(args, { cwd, input, raw = false, allowFail = false } = {}) {
  const r = spawnSync('git', [...SAFE_CONFIG, ...args], {
    cwd,
    input,
    encoding: raw ? 'buffer' : 'utf8',
    env: { ...process.env, ...GIT_ENV },
    shell: false,
    windowsHide: true,
    maxBuffer: 512 * 1024 * 1024,
  })
  if (r.error) {
    if (r.error.code === 'ENOENT') throw new GitError('git が見つかりません。Git をインストールしてから、もう一度実行してください。')
    throw new GitError(`git ${args.join(' ')}: ${r.error.message}`)
  }
  if (r.status !== 0 && !allowFail) {
    const err = raw ? r.stderr.toString('utf8') : r.stderr
    throw new GitError(`git ${args.join(' ')} が失敗しました (終了コード ${r.status}): ${String(err).trim()}`)
  }
  return allowFail ? { status: r.status, stdout: r.stdout, stderr: r.stderr } : r.stdout
}

/**
 * Entries of the tree at `rev` that are not plain files: symbolic links (120000),
 * submodules (160000) and executables (100755). Paths use forward slashes.
 */
export function specialEntries(clone, rev = 'HEAD', paths = []) {
  const out = git(['-C', clone, 'ls-tree', '-r', '-z', '--full-tree', rev, ...(paths.length ? ['--', ...paths] : [])], { raw: true })
  const list = []
  for (const rec of out.toString('utf8').split('\0')) {
    if (!rec) continue
    const tab = rec.indexOf('\t')
    const [mode, type] = rec.slice(0, tab).split(' ')
    if (mode === '120000' || mode === '160000' || mode === '100755') list.push({ mode, type, path: rec.slice(tab + 1) })
  }
  return list
}

export const MODE_LABEL = { '120000': 'シンボリック リンク', '160000': 'サブモジュール', '100755': '実行属性付きファイル' }

/** Sparse-checkout patterns (non-cone): the skill folders plus license and contribution notes at any level. */
export function sparsePatterns(globs) {
  const ci = (word) => [...word].map((c) => (/[a-z]/i.test(c) ? `[${c.toUpperCase()}${c.toLowerCase()}]` : c)).join('')
  return [...globs.map((g) => (g ? `/${g}/` : '/*')), `${ci('licen')}[CcSs]${ci('e')}*`, `${ci('copying')}*`, `${ci('contributing')}*`]
}

/** Pin the safe settings in the clone's own config and (re)apply the sparse patterns. */
export function applySafeSparse(dir, patterns) {
  for (const [k, v] of [['core.symlinks', 'false'], ['core.longpaths', 'true'], ['core.autocrlf', 'false']]) git(['-C', dir, 'config', k, v])
  git(['-C', dir, 'sparse-checkout', 'set', '--no-cone', '--stdin'], { input: patterns.join('\n') + '\n' })
}

export const isCommitId = (ref) => /^[0-9a-f]{40}$/i.test(ref ?? '')

/**
 * Shallow (depth 1), blobless, sparse clone of `url` into `dir`: no hook templates,
 * symlinks written as plain files, no LFS smudge. `ref` is a branch or tag name, a full
 * commit id, or empty for the default branch. Returns the commit id. Nothing in the clone
 * is executed.
 */
export function cloneSparse({ url, dir, patterns, ref = '' }) {
  const branch = ref && !isCommitId(ref) ? ['--branch', ref] : []
  git(['clone', '--template=', '--depth', '1', '--filter=blob:none', '--no-checkout', '--sparse', ...branch, '--', url, dir])
  applySafeSparse(dir, patterns)
  if (isCommitId(ref)) {
    git(['-C', dir, 'fetch', '--depth', '1', '--no-tags', 'origin', ref])
    git(['-C', dir, 'reset', '--hard', '--quiet', 'FETCH_HEAD'])
  } else git(['-C', dir, 'reset', '--hard', '--quiet', 'HEAD'])
  git(['-C', dir, 'clean', '-ffdxq'])
  return git(['-C', dir, 'rev-parse', 'HEAD']).trim()
}

/** Branch and tag names of a remote (`git ls-remote`), without the refs/heads/ or refs/tags/ prefix. */
export function remoteRefs(url) {
  const out = git(['ls-remote', '--heads', '--tags', '--', url])
  const refs = new Set()
  for (const line of out.split('\n')) {
    const ref = line.split('\t')[1]
    const m = ref && /^refs\/(heads|tags)\/(.+?)(\^\{\})?$/.exec(ref)
    if (m) refs.add(m[2])
  }
  return refs
}
