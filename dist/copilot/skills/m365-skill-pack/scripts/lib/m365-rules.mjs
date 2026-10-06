// Limits and allow-lists of Microsoft 365 Copilot custom skills (Agent Builder), as
// documented on learn.microsoft.com on 2026-10-06. See references/m365-constraints.md
// for the sources and for anything measured after that date.

import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/** Resource file types a skill package may contain. */
export const RESOURCE_EXT = new Set([
  '.json', '.xml', '.yaml', '.yml', '.ini', '.config', '.utf8',
  '.docx', '.doc', '.docm', '.pdf', '.txt', '.rtf', '.md',
  '.ppt', '.pptx', '.ppsm', '.xlsx', '.xls', '.xlsm', '.csv', '.tsv',
  '.html', '.htm', '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.log',
])

/** Script types a skill package may contain. Windows script types are absent on purpose. */
export const SCRIPT_EXT = new Set(['.py', '.js', '.mjs', '.cjs', '.ts', '.mts', '.sh', '.bash'])

/** Rejected with a targeted message instead of the generic "not allowed". */
export const WINDOWS_SCRIPT_EXT = new Set(['.ps1', '.psm1', '.psd1', '.cmd', '.bat', '.exe', '.dll', '.vbs'])

/** Text types whose line endings are normalised to LF inside a skill package. */
export const NORMALISE_EOL_EXT = new Set([...SCRIPT_EXT, '.md', '.txt', '.json', '.yaml', '.yml', '.csv', '.tsv', '.ini', '.config'])

export const LIMITS = Object.freeze({
  skillsPerAgent: 8,
  zipBytes: 50 * 1024 * 1024,
  fileBytes: 25 * 1024 * 1024,
  filesPerAgent: 350,
  // The docs say "maximum directory depth of 3" without defining what 0 is. Two nested
  // directories (a/b/file) is the safe reading; --max-depth 3 relaxes it.
  defaultMaxDepth: 2,
  skillInstructionChars: 20_000,
  skillInstructionWarnChars: 18_000,
  agentInstructionChars: 8_000,
  agentInstructionWarnChars: 7_000,
  agentNameChars: 30,
  agentDescriptionChars: 1_000,
})

/** Names silently dropped from a skill package (listed in the report, never packed). */
export const JUNK_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini'])
export const JUNK_DIRS = new Set(['__pycache__', '.git', 'node_modules', '.pytest_cache', '.mypy_cache'])
export const JUNK_EXT = new Set(['.pyc', '.pyo'])

/** Files make-input.mjs copies into _m365/CONVENTIONS/ without reading them. */
export const CONVENTION_FILES = ['CLAUDE.md', 'AGENTS.md', '.github/copilot-instructions.md']

/** Default exclusions for make-input.mjs, on top of .gitignore. */
export const INPUT_EXCLUDES = [
  '.git/**', 'node_modules/**', '**/node_modules/**', 'dist/**', 'build/**', 'out/**', 'target/**',
  '.venv/**', 'venv/**', '**/__pycache__/**', '.m365/**',
  '.env', '.env.*', '**/.env', '**/.env.*',
  '*.pem', '**/*.pem', '*.key', '**/*.key', '*.pfx', '**/*.pfx', '*.p12', '**/*.p12', '*.jks', '**/*.jks',
  '**/id_rsa*', '**/id_ed25519*', '**/*.keystore', '**/secrets.*', '**/credentials.*',
]

/** Extensions treated as binary without sniffing. */
export const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.pdf', '.zip', '.gz', '.tgz', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.class', '.jar', '.pyc', '.woff', '.woff2', '.ttf', '.otf',
  '.mp3', '.mp4', '.mov', '.wav', '.ogg', '.docx', '.xlsx', '.pptx', '.doc', '.xls', '.ppt',
])

export function extOf(name) {
  const base = name.slice(name.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot).toLowerCase()
}

/** Convert a glob (`**`, `*`, `?`) into a RegExp over forward-slash paths. */
export function globToRegExp(glob) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const slash = glob[i + 2] === '/'
        re += slash ? '(?:.*/)?' : '.*'
        i += slash ? 2 : 1
      } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

export function matchesAny(path, globs) {
  return globs.some((g) => (g instanceof RegExp ? g : globToRegExp(g)).test(path))
}

/** Minimal `key: value` frontmatter parser; enough for SKILL.md and the agent sheets. */
export function parseSimpleFrontmatter(text, file = 'SKILL.md') {
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) throw new Error(`${file}: missing YAML frontmatter`)
  const end = text.indexOf('\n---', 3)
  if (end === -1) throw new Error(`${file}: unterminated YAML frontmatter`)
  const raw = text.slice(text.indexOf('\n') + 1, end)
  const data = {}
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (!m) throw new Error(`${file}: frontmatter line is not \`key: value\`: ${line}`)
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    data[m[1]] = v
  }
  const body = text.slice(text.indexOf('\n', end + 1) + 1)
  return { data, body }
}

function walkDir(dir, base, out, depthOf) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name)
    const rel = relative(base, abs).split(sep).join('/')
    if (entry.isSymbolicLink()) {
      out.push({ rel, abs, symlink: true })
      continue
    }
    if (entry.isDirectory()) {
      if (JUNK_DIRS.has(entry.name)) {
        out.push({ rel, abs, junkDir: true })
        continue
      }
      walkDir(abs, base, out, depthOf)
    } else if (entry.isFile()) out.push({ rel, abs, size: lstatSync(abs).size })
  }
  return out
}

/**
 * Validate one skill directory against the Agent Builder rules.
 * Returns { name, description, entries, problems, warnings, notices } where entries are
 * [{ name, data }] ready for the ZIP writer (SKILL.md first), already normalised.
 */
export function validateSkillDir(dir, opts = {}) {
  const { fromTemplate = false, strict = false, keepEol = false, maxDepth = LIMITS.defaultMaxDepth, commonDir = null } = opts
  const problems = []
  const warnings = []
  const notices = []
  const skipped = []
  const label = dir.split(sep).join('/')

  let raw
  try {
    raw = walkDir(dir, dir, [], null)
  } catch (e) {
    return { problems: [`${label}: ${e.message}`], warnings, notices, entries: [], skipped }
  }

  const skillFileName = fromTemplate ? 'SKILL.template.md' : 'SKILL.md'
  const files = new Map()
  for (const f of raw) {
    if (f.symlink) {
      problems.push(`${label}: ${f.rel} is a symbolic link; copy the real file instead`)
      continue
    }
    if (f.junkDir) {
      skipped.push(`${f.rel}/ (junk directory)`)
      continue
    }
    const base = f.rel.slice(f.rel.lastIndexOf('/') + 1)
    if (JUNK_NAMES.has(base) || JUNK_EXT.has(extOf(base))) {
      skipped.push(`${f.rel} (junk)`)
      continue
    }
    if (fromTemplate && base === 'SKILL.md') {
      problems.push(`${label}: both SKILL.md and SKILL.template.md exist; keep one`)
      continue
    }
    files.set(f.rel, f)
  }

  // Common files are merged in under the same validation.
  if (commonDir) {
    let common = []
    try {
      common = walkDir(commonDir, commonDir, [], null).filter((f) => !f.symlink && !f.junkDir)
    } catch (e) {
      problems.push(`${label}: common directory unreadable - ${e.message}`)
    }
    for (const f of common) {
      if (files.has(f.rel)) {
        problems.push(`${label}: ${f.rel} exists both in the skill and in common/`)
        continue
      }
      files.set(f.rel, { ...f, fromCommon: true })
    }
  }

  const skillKey = [...files.keys()].find((k) => k === skillFileName)
  if (!skillKey) {
    problems.push(`${label}: ${skillFileName} is missing at the package root${fromTemplate ? '' : ' (use --from-template for SKILL.template.md)'}`)
    return { problems, warnings, notices, entries: [], skipped }
  }

  const entries = []
  let name = null
  let description = null
  for (const [rel, f] of files) {
    const outName = rel === skillFileName ? 'SKILL.md' : rel
    const ext = extOf(outName)
    const base = outName.slice(outName.lastIndexOf('/') + 1)

    if (base.startsWith('.')) {
      problems.push(`${label}: ${rel} is a dotfile; Microsoft 365 skills cannot carry it`)
      continue
    }
    if (WINDOWS_SCRIPT_EXT.has(ext)) {
      problems.push(`${label}: ${rel} - Microsoft 365 rejects Windows script and binary types (${ext}); use .py, .sh or .mjs`)
      continue
    }
    if (!ext) {
      problems.push(`${label}: ${rel} has no extension; every file needs an allowed extension`)
      continue
    }
    if (!RESOURCE_EXT.has(ext) && !SCRIPT_EXT.has(ext)) {
      problems.push(`${label}: ${rel} - extension ${ext} is not in the allowed resource or script list`)
      continue
    }
    const depth = outName.split('/').length - 1
    if (depth > maxDepth) problems.push(`${label}: ${rel} is nested ${depth} directories deep (max ${maxDepth}; --max-depth to relax)`)
    if (/[\\]/.test(outName) || outName.startsWith('/')) problems.push(`${label}: ${rel} - entry names must use / and be relative`)
    if (!/^[\x20-\x7e]+$/.test(outName)) warnings.push(`${label}: ${rel} has non-ASCII characters in its name; keep names ASCII until UTF-8 names are confirmed`)
    if (f.size > LIMITS.fileBytes) problems.push(`${label}: ${rel} is ${f.size} bytes (max ${LIMITS.fileBytes})`)

    let data = readFileSync(f.abs)

    if (outName === 'SKILL.md') {
      if (data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) {
        if (strict) problems.push(`${label}: ${rel} starts with a UTF-8 BOM`)
        else notices.push(`${label}: ${rel} - stripped UTF-8 BOM`)
        data = data.subarray(3)
      }
      let text = data.toString('utf8')
      if (text.includes('\r\n')) {
        if (strict) problems.push(`${label}: ${rel} has CRLF line endings`)
        else notices.push(`${label}: ${rel} - normalised CRLF to LF`)
        text = text.replace(/\r\n/g, '\n')
        data = Buffer.from(text, 'utf8')
      }
      try {
        const { data: fm, body } = parseSimpleFrontmatter(text, rel)
        name = fm.name
        description = fm.description
        if (!name) problems.push(`${label}: ${rel} frontmatter needs a non-empty \`name\``)
        else if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) warnings.push(`${label}: \`name: ${name}\` is not lowercase-hyphenated; Copilot Studio requires that form`)
        if (!description) problems.push(`${label}: ${rel} frontmatter needs a non-empty \`description\``)
        const chars = [...body].length
        if (chars >= LIMITS.skillInstructionChars) problems.push(`${label}: ${rel} instructions are ${chars} characters (must be under ${LIMITS.skillInstructionChars})`)
        else if (chars >= LIMITS.skillInstructionWarnChars) warnings.push(`${label}: ${rel} instructions are ${chars} characters (limit ${LIMITS.skillInstructionChars})`)
      } catch (e) {
        problems.push(`${label}: ${e.message}`)
      }
    } else if (NORMALISE_EOL_EXT.has(ext) && !keepEol && data.includes(0x0d)) {
      const text = data.toString('utf8')
      if (text.includes('\r\n')) {
        if (strict) problems.push(`${label}: ${rel} has CRLF line endings`)
        else notices.push(`${label}: ${rel} - normalised CRLF to LF`)
        data = Buffer.from(text.replace(/\r\n/g, '\n'), 'utf8')
      }
    }

    if ((ext === '.sh' || ext === '.bash') && !data.toString('utf8', 0, 2).startsWith('#!')) warnings.push(`${label}: ${rel} has no shebang line`)

    entries.push({ name: outName, data })
  }

  entries.sort((a, b) => (a.name === 'SKILL.md' ? -1 : b.name === 'SKILL.md' ? 1 : a.name.localeCompare(b.name)))
  return { name, description, entries, problems, warnings, notices, skipped }
}

/** Count code points of an agent instruction block and report against the Agent Builder limit. */
export function checkAgentInstructions(text, label = 'instructions') {
  const problems = []
  const warnings = []
  if (text.charCodeAt(0) === 0xfeff) problems.push(`${label}: starts with a UTF-8 BOM`)
  const chars = [...text.replace(/^﻿/, '')].length
  if (chars > LIMITS.agentInstructionChars) problems.push(`${label}: ${chars} characters (Agent Builder limit ${LIMITS.agentInstructionChars})`)
  else if (chars > LIMITS.agentInstructionWarnChars) warnings.push(`${label}: ${chars} characters; aim below ${LIMITS.agentInstructionWarnChars} to leave room for edits`)
  return { chars, problems, warnings }
}

/**
 * An agent definition sheet carries its instructions in a fenced block under a
 * `### Instructions` heading; a plain file is taken whole.
 */
export function extractInstructions(text) {
  const idx = text.search(/^### Instructions\s*$/m)
  if (idx === -1) return text
  const m = /^(`{3,})[^\n]*\n([\s\S]*?)\n\1\s*$/m.exec(text.slice(idx))
  return m ? m[2] : text.slice(idx)
}
