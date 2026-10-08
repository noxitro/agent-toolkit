// Safe git plumbing for the skill scout. Upstream repositories are untrusted: they are
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
