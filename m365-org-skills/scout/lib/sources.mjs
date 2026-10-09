// Loading sources.json and fetching each source into the cache as a shallow, sparse,
// symlink-free clone. Nothing from a clone is executed. The clone itself and the JSON
// helpers live in the m365-skill-convert skill (one copy for the scout and the converter).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ConfigError, readJson } from '../../../shared/skills/m365-skill-convert/scripts/lib/config.mjs'
import { applySafeSparse, cloneSparse, git, sparsePatterns, specialEntries } from '../../../shared/skills/m365-skill-convert/scripts/lib/git.mjs'

export { ConfigError, readJson, sparsePatterns }

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const GLOB_RE = /^[A-Za-z0-9_.*?\-/]+$/

/** Folder name of a source inside the cache (the same rule import-upstream.mjs uses for --src). */
export const cacheName = (repo) => repo.split('/')[1]

/**
 * Folder that holds the clones (the --src of import-upstream.mjs). The clones are
 * untrusted working trees, so they live under a folder named node_modules: test runners
 * that discover files on their own (node --test, pytest, Jest) skip node_modules, and
 * `npm test` in this repository would otherwise run upstream files such as
 * test-helper.js (measured with Node 24 before this layout was chosen).
 */
export const clonesDir = (cacheDir) => join(cacheDir, 'node_modules')
export const cloneDir = (cacheDir, repo) => join(clonesDir(cacheDir), cacheName(repo))

export function loadSources(path) {
  const cfg = readJson(path, 'sources.json')
  if (!Array.isArray(cfg.sources)) throw new ConfigError(`${path}: "sources" の配列がありません`)
  const seen = new Map()
  for (const s of cfg.sources) {
    if (typeof s.repo !== 'string' || !REPO_RE.test(s.repo) || s.repo.split('/').some((p) => p === '.' || p === '..')) {
      throw new ConfigError(`${path}: repo ${JSON.stringify(s.repo)} は owner/name の形で書いてください`)
    }
    if (!Array.isArray(s.globs) || !s.globs.length) throw new ConfigError(`${path}: ${s.repo} に globs がありません`)
    for (const g of s.globs) {
      if (typeof g !== 'string' || !GLOB_RE.test(g) || g.startsWith('/') || g.endsWith('/') || g.split('/').some((p) => p === '' || p === '.' || p === '..')) {
        throw new ConfigError(`${path}: ${s.repo} の glob ${JSON.stringify(g)} が不正です(例: "skills/*")`)
      }
    }
    if (s.url !== undefined && (typeof s.url !== 'string' || !/^(https:\/\/|file:\/\/)/.test(s.url))) {
      throw new ConfigError(`${path}: ${s.repo} の url は https:// か file:// で始めてください`)
    }
    const name = cacheName(s.repo)
    if (seen.has(name.toLowerCase())) {
      throw new ConfigError(`${path}: ${seen.get(name.toLowerCase())} と ${s.repo} はキャッシュのフォルダ名 (${name}) が同じです。どちらか一方にしてください`)
    }
    seen.set(name.toLowerCase(), s.repo)
  }
  return cfg.sources
}

export const metaPath = (cacheDir, source) => join(cacheDir, `${cacheName(source.repo)}.scout.json`)

export function readMeta(cacheDir, source) {
  const p = metaPath(cacheDir, source)
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null
}

/**
 * Clone (or update) one source into <cacheDir>/<repo name>. Returns the metadata written
 * next to it: commit, commit date, fetch time and the special tree entries.
 */
export function fetchSource(cacheDir, source, log = () => {}) {
  mkdirSync(cacheDir, { recursive: true })
  const dir = cloneDir(cacheDir, source.repo)
  mkdirSync(clonesDir(cacheDir), { recursive: true })
  const url = source.url ?? `https://github.com/${source.repo}.git`
  if (existsSync(dir) && !existsSync(join(dir, '.git'))) {
    throw new ConfigError(`${dir} は git の clone ではありません。フォルダを消してから、もう一度実行してください`)
  }
  const patterns = sparsePatterns(source.globs)
  if (!existsSync(dir)) {
    log(`${source.repo}: 取得しています (${url})`)
    cloneSparse({ url, dir, patterns })
  } else {
    log(`${source.repo}: 更新しています`)
    const current = git(['-C', dir, 'remote', 'get-url', 'origin']).trim()
    if (current !== url) git(['-C', dir, 'remote', 'set-url', 'origin', url])
    applySafeSparse(dir, patterns)
    git(['-C', dir, 'fetch', '--depth', '1', '--no-tags', 'origin', 'HEAD'])
    git(['-C', dir, 'reset', '--hard', '--quiet', 'FETCH_HEAD'])
    git(['-C', dir, 'clean', '-ffdxq'])
  }
  const meta = {
    repo: source.repo,
    url,
    commit: git(['-C', dir, 'rev-parse', 'HEAD']).trim(),
    date: git(['-C', dir, 'log', '-1', '--format=%cs']).trim(),
    fetchedAt: new Date().toISOString(),
    globs: source.globs,
    special: specialEntries(dir),
  }
  writeFileSync(metaPath(cacheDir, source), JSON.stringify(meta, null, 2) + '\n')
  return meta
}
