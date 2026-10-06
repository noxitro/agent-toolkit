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
  for (const s of segs) {
    if (s === '' ) return 'empty segment'
    if (s === '.' || s === '..') return `"${s}" segment`
    if (isGitSegment(s)) return '.git segment'
    if (/[:<>"|?*]/.test(s) || /[\x00-\x1f]/.test(s)) return 'reserved character in segment'
    if (/[. ]$/.test(s)) return 'segment ends with a dot or space'
  }
  return null
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

export function isProtocolPath(p) {
  return p.startsWith(PROTOCOL_PREFIX)
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
    let text = f.data.toString('utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
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

/** Keep CRLF when the existing target file uses CRLF; new files get LF. */
export function matchLineEndings(content, existing) {
  if (existing && existing.includes('\r\n')) return content.replace(/\r?\n/g, '\r\n')
  return content
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
