// Read-only facts about a LOCAL git work tree (the converter's local or installed input)
// without running git. A repository on the user's disk may carry a .git/config that makes
// git run programs (gpg.program with log.showSignature, core.fsmonitor, diff drivers ...),
// so git is never started with such a folder as its repository. Instead this reads the few
// files needed directly: HEAD and refs for the commit, config for the origin URL, and the
// index for entries recorded as symbolic links or submodules.
//
// Everything here is best effort and never throws: what could not be read is returned as a
// note for the report, so the caller can say so instead of silently dropping it.

import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

const MAX_INDEX_BYTES = 256 * 1024 * 1024

function readSmall(path, max = 1024 * 1024) {
  try {
    if (statSync(path).size > max) return null
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** The git directory of work tree `root` (.git as a folder, or a "gitdir:" file), or null. */
export function gitDirOf(root) {
  const dotGit = join(root, '.git')
  let st
  try {
    st = statSync(dotGit)
  } catch {
    return null
  }
  if (st.isDirectory()) return dotGit
  const text = readSmall(dotGit, 64 * 1024)
  const m = text && /^gitdir:\s*(.+?)\s*$/m.exec(text)
  if (!m) return null
  const dir = isAbsolute(m[1]) ? m[1] : resolve(root, m[1])
  return existsSync(dir) ? dir : null
}

/** Minimal git-config reader: { 'section.sub.key': value } for the keys we need (last one wins). */
export function parseGitConfig(text) {
  const out = {}
  let section = ''
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const sec = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]/.exec(line)
    if (sec) {
      section = sec[1].toLowerCase() + (sec[2] !== undefined ? `.${sec[2].replace(/\\(.)/g, '$1')}` : '')
      continue
    }
    const kv = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=\s*(.*))?$/.exec(line)
    if (!kv || !section) continue
    let v = (kv[2] ?? 'true').replace(/\s+[#;].*$/, '').trim()
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1)
    out[`${section}.${kv[1].toLowerCase()}`] = v
  }
  return out
}

const REF_RE = /^refs\/[A-Za-z0-9._\/-]+$/
const OID_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/

function resolveRef(gitDir, commonDir, ref, depth = 0) {
  if (depth > 5 || !REF_RE.test(ref) || ref.split('/').some((p) => p === '..' || p === '.' || p === '')) return null
  for (const base of [gitDir, commonDir]) {
    const text = readSmall(join(base, ...ref.split('/')), 4096)
    if (text === null) continue
    const t = text.trim()
    if (OID_RE.test(t)) return t
    const sym = /^ref:\s*(\S+)$/.exec(t)
    return sym ? resolveRef(gitDir, commonDir, sym[1], depth + 1) : null
  }
  const packed = readSmall(join(commonDir, 'packed-refs'), 64 * 1024 * 1024)
  if (packed) {
    for (const line of packed.split(/\r?\n/)) {
      const [oid, name] = line.split(' ')
      if (name === ref && OID_RE.test(oid ?? '')) return oid
    }
  }
  return null
}

/** Mode and path of every index entry, from the raw index file (versions 2, 3 and 4). */
export function parseIndex(buf, hashLen = 20) {
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'DIRC') throw new Error('not a git index')
  const version = buf.readUInt32BE(4)
  if (![2, 3, 4].includes(version)) throw new Error(`index version ${version} is not supported`)
  const count = buf.readUInt32BE(8)
  const entries = []
  let pos = 12
  let prev = Buffer.alloc(0)
  for (let i = 0; i < count; i++) {
    const start = pos
    if (pos + 40 + hashLen + 2 > buf.length) throw new Error('index is truncated')
    const mode = buf.readUInt32BE(pos + 24)
    pos += 40 + hashLen
    const flags = buf.readUInt16BE(pos)
    pos += 2
    if (flags & 0x4000) {
      if (version < 3) throw new Error('extended flag in a version 2 index')
      pos += 2
    }
    let name
    if (version === 4) {
      // Prefix compression: strip N bytes from the previous name, then a NUL-terminated suffix.
      let c = buf[pos++]
      let strip = c & 127
      while (c & 128) {
        c = buf[pos++]
        strip = ((strip + 1) << 7) | (c & 127)
      }
      const end = buf.indexOf(0, pos)
      if (end < 0 || strip > prev.length) throw new Error('index entry name is malformed')
      name = Buffer.concat([prev.subarray(0, prev.length - strip), buf.subarray(pos, end)])
      pos = end + 1
    } else {
      const len = flags & 0xfff
      const end = len < 0xfff ? pos + len : buf.indexOf(0, pos)
      if (end < 0 || end > buf.length) throw new Error('index entry name is malformed')
      name = buf.subarray(pos, end)
      // 1 to 8 NUL bytes pad the entry to a multiple of 8.
      pos = start + ((end - start + 8) & ~7)
    }
    prev = name
    entries.push({ mode: mode.toString(8).padStart(6, '0'), path: name.toString('utf8') })
  }
  // Extensions: a split index ("link") keeps most entries in a shared file we do not read;
  // a sparse index has directory entries whose content is not listed.
  const exts = []
  while (pos + 8 <= buf.length - hashLen) {
    const sig = buf.toString('latin1', pos, pos + 4)
    const size = buf.readUInt32BE(pos + 4)
    exts.push(sig)
    pos += 8 + size
  }
  return { version, entries, split: exts.includes('link'), sparse: exts.includes('sdir') }
}

/** Accept only GitHub origins, written back as https://github.com/<owner>/<repo>. */
export function githubOrigin(url) {
  if (typeof url !== 'string') return null
  const u = url.trim()
  const m =
    /^https?:\/\/(?:[^@/\s]*@)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?(?:[?#].*)?$/i.exec(u) ||
    /^(?:ssh:\/\/)?git@github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(u)
  if (!m || [m[1], m[2]].some((p) => p === '.' || p === '..')) return null
  return `https://github.com/${m[1]}/${m[2]}`
}

/**
 * Facts about the work tree at `root` for the skill folder `rel` (posix, '' for the root):
 *   { commit, remote, special: [{ mode, path }], notes: [] }
 * remote is a public GitHub URL or null; special lists index entries recorded as symbolic
 * links (120000), submodules (160000) or executables (100755).
 */
export function readLocalRepo(root, rel) {
  const notes = []
  const facts = { commit: null, date: null, remote: null, special: [], notes }
  const gitDir = gitDirOf(root)
  if (!gitDir) {
    notes.push('git の管理情報(.git)を読めなかったので、git 上のシンボリック リンクとサブモジュールは確かめていない')
    return facts
  }
  const commonText = readSmall(join(gitDir, 'commondir'), 4096)
  const commonDir = commonText ? resolve(gitDir, commonText.trim()) : gitDir
  const cfg = parseGitConfig(readSmall(join(commonDir, 'config')) ?? '')
  facts.remote = githubOrigin(cfg['remote.origin.url'])

  const head = (readSmall(join(gitDir, 'HEAD'), 4096) ?? '').trim()
  if (OID_RE.test(head)) facts.commit = head
  else {
    const m = /^ref:\s*(\S+)$/.exec(head)
    facts.commit = m ? resolveRef(gitDir, commonDir, m[1]) : null
  }

  const hashLen = (cfg['extensions.objectformat'] ?? 'sha1').toLowerCase() === 'sha256' ? 32 : 20
  const indexPath = join(gitDir, 'index')
  if (!existsSync(indexPath)) return facts
  try {
    if (statSync(indexPath).size > MAX_INDEX_BYTES) throw new Error('index is too large')
    const idx = parseIndex(readFileSync(indexPath), hashLen)
    const inSkill = (p) => !rel || p === rel || p.startsWith(`${rel}/`)
    for (const e of idx.entries) {
      if (!inSkill(e.path)) continue
      if (e.mode === '120000' || e.mode === '160000' || e.mode === '100755') facts.special.push({ mode: e.mode, path: e.path })
    }
    if (idx.split) notes.push('git のインデックスが分割形式(split index)なので、一部のエントリしか確かめていない(シンボリック リンク・サブモジュールの見落としがありうる)')
    const collapsed = (d) => inSkill(d) || (rel && rel.startsWith(`${d}/`))
    if (idx.sparse && idx.entries.some((e) => e.mode === '040000' && collapsed(e.path.replace(/\/$/, '')))) {
      notes.push('git のインデックスが sparse 形式で、スキルのフォルダの中身が一覧に無い(シンボリック リンク・サブモジュールの見落としがありうる)')
    }
  } catch (e) {
    notes.push(`git のインデックスを読めなかった(${e.message})ので、git 上のシンボリック リンクとサブモジュールは確かめていない`)
  }
  return facts
}
