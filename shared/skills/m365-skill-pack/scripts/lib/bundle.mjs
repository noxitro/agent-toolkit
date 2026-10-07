// Bundle helpers shared by make-input.mjs and unpack-output.mjs. The format is specified
// in references/bundle-format.md; keep this file and m365/skills/common/scripts/bundle_io.py
// in agreement with that document.

import { BINARY_EXT, extOf } from './m365-rules.mjs'

export const BUNDLE_MAGIC = '# m365-bundle v1'
export const PROTOCOL_PREFIX = '_m365/'

/** Why a path is unsafe, or null when it follows the path model. */
export function unsafePathReason(p) {
  if (typeof p !== 'string' || p.length === 0) return 'empty path'
  if (p.includes('\\')) return 'backslash in path'
  if (p.startsWith('/')) return 'absolute path'
  if (/^[A-Za-z]:/.test(p)) return 'drive letter in path'
  if (p.includes('\0')) return 'NUL in path'
  const segs = p.split('/')
  // `_M365/...` would bypass every exact-case protocol check, and on a case-insensitive
  // file system it is the same directory as `_m365/`.
  if (segs[0] !== '_m365' && segs[0].toLowerCase() === '_m365') return 'case variant of the reserved _m365/ prefix'
  for (const s of segs) {
    if (s === '' ) return 'empty segment'
    if (s === '.' || s === '..') return `"${s}" segment`
    if (isGitSegment(s)) return '.git segment'
    if (/[:<>"|?*]/.test(s) || /[\x00-\x1f]/.test(s)) return 'reserved character in segment'
    if (/[. ]$/.test(s)) return 'segment ends with a dot or space'
    // `### FILE <path> [flags]` would read the suffix as header flags.
    if (/ \[[^\]]*\]$/.test(s)) return 'segment ends with " [...]", which the Markdown header reserves for flags'
    if (isWindowsDeviceName(s)) return 'Windows reserved device name'
    if (/~\d/.test(s)) return '8.3 short-name pattern (~N) in segment'
  }
  return null
}

/** CON, PRN, AUX, NUL, COM1-9, LPT1-9 in any letter case, with or without an extension. */
export function isWindowsDeviceName(seg) {
  const stem = seg.replace(/[. ]+$/, '').split('.')[0].replace(/ +$/, '')
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)
}

/**
 * Case-insensitive `.git`, its 8.3 short names (`GIT~1`), and NTFS stream or trailing
 * junk variants - the same family git's protectNTFS/protectHFS refuse.
 */
export function isGitSegment(seg) {
  const s = seg.toLowerCase().replace(/[. ]+$/, '')
  return s === '.git' || /^git~\d+$/.test(s) || s.startsWith('.git:')
}

export function assertSafePath(p) {
  const why = unsafePathReason(p)
  if (why) throw new Error(`unsafe path "${p}": ${why}`)
  return p
}

/** Under the reserved `_m365/` prefix, in any letter case (unsafePathReason refuses the variants). */
export function isProtocolPath(p) {
  return p.slice(0, PROTOCOL_PREFIX.length).toLowerCase() === PROTOCOL_PREFIX
}

/** Case- and normalisation-insensitive key, as the default macOS and Windows file systems compare names. */
export function foldPath(p) {
  return p.normalize('NFC').toLowerCase()
}

/** Task slugs name directories under .m365/, so they follow the same rule as make-input. */
export const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
export function isSafeSlug(s) {
  return typeof s === 'string' && SLUG_RE.test(s) && !/^\.+$/.test(s) && !isGitSegment(s)
}

/** NUL in the first 8 KiB or a known binary extension. */
export function isBinary(data, path = '') {
  if (BINARY_EXT.has(extOf(path))) return true
  const n = Math.min(data.length, 8192)
  for (let i = 0; i < n; i++) if (data[i] === 0) return true
  return false
}

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/** Strict UTF-8 decode (BOM kept); null when the bytes are not valid UTF-8. */
export function decodeUtf8(data) {
  try {
    return UTF8.decode(data)
  } catch {
    return null
  }
}

/**
 * The text normalisation formatBundle applies to every file: strict UTF-8, BOM dropped,
 * CRLF and lone CR to LF. null when the bytes are not UTF-8. A sandbox that started from
 * a Markdown bundle hashed exactly this, so the unpacker compares against it too.
 */
export function normaliseText(data) {
  const text = decodeUtf8(data)
  return text === null ? null : text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

/**
 * Give new text bytes the BOM and line-ending style (CRLF or lone CR) of the local file
 * they replace, so a file that differs from the snapshot only by that normalisation keeps
 * its style. Line endings are restored only when every break in the local file had the
 * same style: a mixed file has no single style to restore, so the new text keeps its own.
 * Bytes that are not UTF-8 text are returned unchanged.
 */
export function restoreTextStyle(data, local) {
  const text = decodeUtf8(data)
  const localText = local ? decodeUtf8(local) : null
  if (text === null || localText === null) return data
  let out = text
  if (localText.startsWith('\uFEFF') && !out.startsWith('\uFEFF')) out = `\uFEFF${out}`
  const styles = new Set(localText.match(/\r\n|\r|\n/g) ?? [])
  if (styles.size === 1 && !styles.has('\n')) out = out.replace(/\r?\n/g, [...styles][0])
  return out === text ? data : Buffer.from(out, 'utf8')
}

function longestBacktickRun(text) {
  let best = 0
  let run = 0
  for (const ch of text) {
    if (ch === '`') best = Math.max(best, ++run)
    else run = 0
  }
  return best
}

const INFO_BY_EXT = {
  '.py': 'python', '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.ts': 'typescript',
  '.md': 'markdown', '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml', '.sh': 'bash', '.html': 'html',
  '.css': 'css', '.toml': 'toml', '.xml': 'xml', '.txt': 'text',
}

/**
 * @param {{ task: string, kind: 'input'|'output'|'audit', round?: number,
 *           files: { path: string, data: Buffer }[], deletes?: string[],
 *           skipped?: { path: string, reason: string }[], created?: Date }} spec
 * @returns {string} Markdown bundle text (LF, no BOM)
 */
export function formatBundle(spec) {
  const { task, kind, round = 0, files, deletes = [], skipped = [], created = new Date() } = spec
  const out = []
  out.push(BUNDLE_MAGIC)
  out.push(`- task: ${task}`)
  out.push(`- kind: ${kind}`)
  out.push(`- round: ${round}`)
  out.push(`- created: ${created.toISOString()}`)
  out.push('- eol: lf')
  out.push(`- files: ${files.length}`)
  out.push('')
  out.push('## Files')
  out.push('')
  for (const f of files) {
    assertSafePath(f.path)
    let text = normaliseText(f.data)
    if (text === null) throw new Error(`bundle: ${f.path} is not UTF-8 text`)
    const hasContent = text.length > 0
    const noeol = hasContent && !text.endsWith('\n')
    if (!noeol && text.endsWith('\n')) text = text.slice(0, -1)
    const fence = '`'.repeat(Math.max(3, longestBacktickRun(text) + 1))
    const info = INFO_BY_EXT[extOf(f.path)] ?? ''
    out.push(`### FILE ${f.path}${noeol ? ' [noeol]' : ''}`)
    out.push(fence + info)
    // A file holding just "\n" becomes one empty body line, so it round-trips as "\n".
    if (hasContent) out.push(text)
    out.push(fence)
    out.push('')
  }
  for (const d of deletes) {
    assertSafePath(d)
    out.push(`### DELETE ${d}`)
    out.push('')
  }
  if (skipped.length) {
    out.push('## Skipped')
    out.push('')
    for (const s of skipped) out.push(`- ${s.path} (${s.reason})`)
    out.push('')
  }
  return out.join('\n')
}

/**
 * @param {string} text
 * @returns {{ header: Record<string,string>, files: { path: string, content: string, noeol: boolean }[],
 *            deletes: string[], skipped: { path: string, reason: string }[] }}
 */
export function parseBundle(text) {
  text = text.replace(/^﻿/, '').replace(/\r\n/g, '\n')
  const lines = text.split('\n')
  if (lines[0] !== BUNDLE_MAGIC) throw new Error(`not a bundle: first line must be "${BUNDLE_MAGIC}"`)
  const header = {}
  let i = 1
  for (; i < lines.length; i++) {
    const m = /^- ([a-z]+): (.*)$/.exec(lines[i])
    if (!m) break
    header[m[1]] = m[2]
  }
  if (header.kind && !['input', 'output', 'audit'].includes(header.kind)) throw new Error(`bundle: unknown kind "${header.kind}"`)

  const files = []
  const deletes = []
  const skipped = []
  let inSkipped = false
  for (; i < lines.length; i++) {
    const line = lines[i]
    if (line === '## Skipped') {
      inSkipped = true
      continue
    }
    if (inSkipped) {
      const m = /^- (.+?) \((.+)\)$/.exec(line)
      if (m) skipped.push({ path: m[1], reason: m[2] })
      continue
    }
    const h = /^### (FILE|DELETE) (.+?)(?: \[([a-z,]+)\])?$/.exec(line)
    if (!h) continue
    const path = assertSafePath(h[2])
    if (files.some((f) => f.path === path) || deletes.includes(path)) throw new Error(`bundle: duplicate path ${path}`)
    if (h[1] === 'DELETE') {
      deletes.push(path)
      continue
    }
    const flags = new Set((h[3] ?? '').split(',').filter(Boolean))
    const open = /^(`{3,})/.exec(lines[i + 1] ?? '')
    if (!open) throw new Error(`bundle: ${path} is not followed by a code fence`)
    const fence = open[1]
    let j = i + 2
    const body = []
    for (; j < lines.length; j++) {
      if (lines[j] === fence) break
      body.push(lines[j])
    }
    if (j >= lines.length) throw new Error(`bundle: unterminated fence for ${path}`)
    let content = body.join('\n')
    if (!flags.has('noeol') && (content.length > 0 || body.length > 0)) content += '\n'
    if (body.length === 0 && !flags.has('noeol')) content = ''
    files.push({ path, content, noeol: flags.has('noeol') })
    i = j
  }
  return { header, files, deletes, skipped }
}

/** Pull the machine-readable summary out of _m365/AUDIT.md. Returns null when absent or malformed. */
export function parseAuditSummary(text) {
  text = text.replace(/^﻿/, '').replace(/\r\n/g, '\n')
  if (!text.startsWith('# AUDIT')) return { error: 'AUDIT.md does not start with "# AUDIT"' }
  const m = /```json\s*\n([\s\S]*?)\n```/.exec(text)
  if (!m) return { error: 'no fenced json block in AUDIT.md' }
  try {
    const summary = JSON.parse(m[1])
    if (summary.schema !== 'm365-audit/1') return { error: `unexpected schema "${summary.schema}"` }
    if (!['PASS', 'FAIL'].includes(summary.verdict)) return { error: `verdict must be PASS or FAIL, got "${summary.verdict}"` }
    return { summary }
  } catch (e) {
    return { error: `AUDIT.md json block is invalid: ${e.message}` }
  }
}
