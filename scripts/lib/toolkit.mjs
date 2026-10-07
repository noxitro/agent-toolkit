// Shared helpers for the build / validate scripts.
// Single source of truth: shared/**. Everything under plugins/*/{skills,commands,agents}
// and dist/** is generated from it by scripts/build.mjs.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import YAML from 'yaml'

// Resolved from the invocation directory rather than this file's location, so the same
// toolchain can be run from a sibling repository that reuses this build.
export const ROOT = process.env.AGENT_TOOLKIT_ROOT ? resolve(process.env.AGENT_TOOLKIT_ROOT) : process.cwd()
export const SHARED = join(ROOT, 'shared')
export const CONFIG_FILE = join(ROOT, 'toolkit.config.json')

// Per-repository settings, so this file stays byte-identical across the repositories that
// share the toolchain. Keeping it identical is what makes moving an asset between them a
// plain file move. A parse error is reported by ensureRoot() rather than thrown at import.
let configError = null
let config = {}
if (existsSync(CONFIG_FILE)) {
  try {
    config = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) ?? {}
  } catch (e) {
    configError = e.message
  }
}
export { config }

/**
 * Because ROOT follows the invocation directory, running a script from the wrong directory
 * would otherwise treat that directory as the toolkit - and the build wipes OWNED_DIRS
 * there. Every script calls this before touching anything; it exits non-zero unless ROOT
 * has both shared/ and toolkit.config.json.
 */
export function ensureRoot(script) {
  const missing = []
  if (!isDir(SHARED)) missing.push('shared/')
  if (!existsSync(CONFIG_FILE)) missing.push('toolkit.config.json')
  if (missing.length) {
    console.error(
      `${script}: ${ROOT} is not an agent-toolkit repository (missing ${missing.join(' and ')}).\n` +
        '  Run it from the repository root, or set AGENT_TOOLKIT_ROOT to that root. Nothing was changed.'
    )
    process.exit(2)
  }
  if (configError) {
    console.error(`${script}: toolkit.config.json is not valid JSON - ${configError}`)
    process.exit(2)
  }
}

/** Claude Code plugin that receives every `claude` target asset. */
export const CLAUDE_PLUGIN = config.claudePlugin ?? 'toolkit-core'

/** Output roots this build owns. Anything here is wiped and regenerated. */
export const OWNED_DIRS = [
  join('plugins', CLAUDE_PLUGIN, 'skills'),
  join('plugins', CLAUDE_PLUGIN, 'commands'),
  join('plugins', CLAUDE_PLUGIN, 'agents'),
  'dist',
]

export const KINDS = ['skills', 'commands', 'agents']
export const TARGETS = ['claude', 'opencode', 'copilot']
/** The only frontmatter keys allowed at the top level of a shared asset. */
export const PORTABLE_KEYS = ['name', 'description', 'targets', 'harness']
/** Keys allowed under `harness.<target>`, and the values `emit` may take. */
export const HARNESS_KEYS = ['frontmatter', 'emit', 'skip']
export const EMIT_KINDS = ['skill', 'command', 'agent']

// agentskills.io constraints, also enforced by Claude Code and Copilot (VS 2026 18.5+).
export const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/
export const NAME_MAX = 64
export const DESC_MAX = 1024

/** `{{ARGS}}` in a shared body becomes the harness-native argument placeholder. */
const PLACEHOLDERS = {
  claude: { ARGS: '$ARGUMENTS' },
  opencode: { ARGS: '$ARGUMENTS' },
  copilot: { ARGS: '${input:args}' },
}

// The path is deliberately described as not-local: an agent reading a bare relative path in
// its own instructions will try to open it, waste a tool call, and get a permission error.
const BANNER = (src) =>
  `<!-- Generated file - do not edit this copy; the next build overwrites it. It is generated from ${src} in the agent-toolkit repository, which is not present alongside this file and must not be opened. -->`

/**
 * Sources are LF in the repository, but a checkout with core.autocrlf=true hands them
 * over with CRLF; normalising here keeps the YAML parser and the generated output stable.
 */
function readSource(file) {
  return readFileSync(file, 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n')
}

// Both fence lines must be exactly `---`; only trailing spaces/tabs and a CR are tolerated.
// A closing fence at end of file (no newline after it) means an empty body.
export function splitFrontmatter(text, file) {
  const open = /^---[ \t]*\r?\n/.exec(text)
  if (!open) throw new Error(`${file}: missing YAML frontmatter (the first line must be \`---\`)`)
  const rest = text.slice(open[0].length)
  const close = /^---[ \t]*\r?$/m.exec(rest)
  if (!close) throw new Error(`${file}: unterminated YAML frontmatter (no closing \`---\` line)`)
  const raw = rest.slice(0, close.index)
  const after = close.index + close[0].length
  const body = rest.slice(rest[after] === '\n' ? after + 1 : after)
  let data
  try {
    data = YAML.parse(raw) ?? {}
  } catch (e) {
    throw new Error(`${file}: invalid YAML frontmatter - ${e.message}`)
  }
  if (typeof data !== 'object' || Array.isArray(data)) throw new Error(`${file}: frontmatter must be a mapping`)
  return { data, body }
}

function listEntries(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return []
  }
}

function entryType(entry) {
  if (entry.isSymbolicLink()) return 'symlink'
  if (entry.isDirectory()) return 'directory'
  if (entry.isFile()) return 'file'
  return 'special file'
}

/**
 * Walk a tree without following links. Returns { files, others, emptyDirs }: regular files,
 * entries that are neither a file nor a directory (symlinks, sockets, ...) as
 * { path, type }, and the top-most directories holding no entry other than empty
 * directories. All paths are posix and relative to `base`.
 */
export function scanTree(dir, base = dir, out = { files: [], others: [], emptyDirs: [] }) {
  let found = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    const rel = relative(base, full).split(sep).join('/')
    const type = entryType(entry)
    if (type === 'directory') {
      const before = out.emptyDirs.length
      const inner = scanTree(full, base, out).found
      if (inner === 0) {
        // Report only the top-most empty directory, not each level below it.
        out.emptyDirs.splice(before)
        out.emptyDirs.push(rel)
      }
      found += inner
    } else {
      found++
      if (type === 'file') out.files.push(rel)
      else out.others.push({ path: rel, type })
    }
  }
  return Object.assign(out, { found })
}

/** Regular files under `dir` (posix, relative). Links and special files are not followed. */
export function walk(dir) {
  return scanTree(dir).files
}

export function relPath(abs) {
  return relative(ROOT, abs).split(sep).join('/')
}

/**
 * Discover every asset under shared/. Returns a list of
 * { kind, name, sourceFile, sourceDir, extraFiles, data, body, text }.
 *
 * Layout problems that are not about one asset's frontmatter (a skill directory without
 * SKILL.md, a symlink, unparsable frontmatter) go to `report.problems`; entries that are
 * skipped on purpose but are probably a mistake go to `report.warnings`. Without a
 * `report`, any problem is thrown.
 */
export function loadAssets(report) {
  const sink = report ?? { problems: [], warnings: [] }
  const assets = []

  const read = (file) => {
    try {
      const text = readSource(file)
      return { ...splitFrontmatter(text, relPath(file)), text }
    } catch (e) {
      sink.problems.push(e.message)
      return null
    }
  }

  const skillsDir = join(SHARED, 'skills')
  for (const entry of listEntries(skillsDir)) {
    const dir = join(skillsDir, entry.name)
    const at = relPath(dir)
    const type = entryType(entry)
    if (type !== 'directory') {
      // A symlinked skill would be skipped by the directory scan and never shipped.
      if (type === 'file') sink.warnings.push(`${at}: not a directory - skipped (skills live in shared/skills/<name>/SKILL.md)`)
      else sink.problems.push(`${at}: is a ${type} - shared/ must contain real files and directories only`)
      continue
    }
    const tree = scanTree(dir)
    for (const o of tree.others)
      sink.problems.push(`${at}/${o.path}: is a ${o.type} - it would be dropped from the generated output; copy the real file in instead`)
    if (!tree.files.includes('SKILL.md')) {
      sink.problems.push(`${at}: skill directory has no SKILL.md`)
      continue
    }
    const file = join(dir, 'SKILL.md')
    const parsed = read(file)
    if (!parsed) continue
    assets.push({
      kind: 'skills',
      name: entry.name,
      sourceFile: relPath(file),
      sourceDir: dir,
      extraFiles: tree.files.filter((f) => f !== 'SKILL.md'),
      ...parsed,
    })
  }

  for (const kind of ['commands', 'agents']) {
    for (const entry of listEntries(join(SHARED, kind))) {
      const file = join(SHARED, kind, entry.name)
      const at = relPath(file)
      const type = entryType(entry)
      if (type === 'file' && entry.name.endsWith('.md')) {
        const parsed = read(file)
        if (!parsed) continue
        assets.push({
          kind,
          name: entry.name.replace(/\.md$/, ''),
          sourceFile: at,
          sourceDir: null,
          extraFiles: [],
          ...parsed,
        })
      } else if (type === 'file' || type === 'directory') {
        sink.warnings.push(`${at}: skipped - only top-level .md files in shared/${kind}/ are assets`)
      } else {
        sink.problems.push(`${at}: is a ${type} - shared/ must contain real files and directories only`)
      }
    }
  }

  if (!report && sink.problems.length) throw new Error(sink.problems.join('\n'))
  return assets.sort((a, b) => (a.kind + a.name).localeCompare(b.kind + b.name))
}

/** Canonical-schema validation. Returns an array of human-readable problem strings. */
export function validateAsset(asset) {
  const problems = []
  const at = asset.sourceFile
  const { name, description, targets, harness } = asset.data

  // Only the portable keys live at the top level; anything else would be dropped by
  // emit() without a trace, so a misplaced `allowed-tools` or `model` is an error here.
  for (const key of Object.keys(asset.data))
    if (!PORTABLE_KEYS.includes(key))
      problems.push(`${at}: top-level key \`${key}\` is not portable - move it under \`harness.<target>.frontmatter\``)

  if (typeof name !== 'string' || !name) {
    problems.push(`${at}: \`name\` is required`)
  } else {
    if (name !== asset.name)
      problems.push(
        `${at}: \`name: ${name}\` must match the ${asset.kind === 'skills' ? 'directory' : 'file'} name \`${asset.name}\``
      )
    if (name.length > NAME_MAX) problems.push(`${at}: \`name\` is ${name.length} chars (max ${NAME_MAX})`)
    if (!NAME_RE.test(name)) problems.push(`${at}: \`name\` must be lowercase alphanumeric words joined by single hyphens`)
  }

  if (typeof description !== 'string' || !description.trim()) problems.push(`${at}: \`description\` is required`)
  else if (description.length > DESC_MAX) problems.push(`${at}: \`description\` is ${description.length} chars (max ${DESC_MAX})`)

  if (!Array.isArray(targets) || targets.length === 0) problems.push(`${at}: \`targets\` must be a non-empty list`)
  else
    for (const t of targets)
      if (!TARGETS.includes(t)) problems.push(`${at}: unknown target \`${t}\` (allowed: ${TARGETS.join(', ')})`)

  if (harness !== undefined) {
    if (!isMapping(harness)) {
      problems.push(`${at}: \`harness\` must be a mapping`)
    } else {
      for (const [t, cfg] of Object.entries(harness)) {
        if (!TARGETS.includes(t)) problems.push(`${at}: \`harness.${t}\` is not a known target`)
        else if (Array.isArray(targets) && !targets.includes(t))
          problems.push(`${at}: \`harness.${t}\` configures a harness that is not in \`targets\` - add it there or remove the block`)
        if (!isMapping(cfg)) {
          problems.push(`${at}: \`harness.${t}\` must be a mapping`)
          continue
        }
        for (const key of Object.keys(cfg))
          if (!HARNESS_KEYS.includes(key)) problems.push(`${at}: unknown key \`harness.${t}.${key}\``)
        if (cfg.frontmatter !== undefined) {
          if (!isMapping(cfg.frontmatter)) problems.push(`${at}: \`harness.${t}.frontmatter\` must be a mapping`)
          else
            for (const key of ['name', 'description'])
              if (key in cfg.frontmatter)
                problems.push(`${at}: \`harness.${t}.frontmatter.${key}\` is not allowed - \`${key}\` comes from the portable top-level key`)
        }
        if (cfg.emit !== undefined && !EMIT_KINDS.includes(cfg.emit))
          problems.push(`${at}: \`harness.${t}.emit: ${cfg.emit}\` is not one of ${EMIT_KINDS.join(', ')}`)
        if (cfg.skip !== undefined && typeof cfg.skip !== 'boolean')
          problems.push(`${at}: \`harness.${t}.skip\` must be true or false`)
      }
    }
  }

  // Bundled files only travel with a skill emitted as a skill directory. Emitted as a
  // command or agent (OpenCode's default for skills) they would be silently dropped.
  const extraFiles = asset.extraFiles ?? []
  if (asset.kind === 'skills' && extraFiles.length && Array.isArray(targets)) {
    const cfgs = isMapping(harness) ? harness : {}
    for (const t of targets.filter((x) => TARGETS.includes(x))) {
      const cfg = isMapping(cfgs[t]) ? cfgs[t] : {}
      if (cfg.skip === true) continue
      const emitAs = cfg.emit ?? defaultEmit(asset.kind, t)
      if (emitAs !== 'skill')
        problems.push(
          `${at}: is emitted for \`${t}\` as a single ${emitAs} file, which would drop its ${extraFiles.length} bundled file(s) ` +
            `(${extraFiles.slice(0, 3).join(', ')}${extraFiles.length > 3 ? ', ...' : ''}) - remove \`${t}\` from \`targets\` or set \`harness.${t}.skip: true\``
        )
    }
  }

  if (!asset.body.trim()) problems.push(`${at}: body is empty`)

  return problems
}

// `{{ARGS}}` becomes the harness-native placeholder. Text that has to *talk about* the
// canonical token (authoring guidance, reviewers) writes `{{literal:ARGS}}`, which comes
// out as the literal `{{ARGS}}` on every harness.
function renderBody(body, target) {
  let out = body
  for (const [token, value] of Object.entries(PLACEHOLDERS[target])) out = out.replaceAll(`{{${token}}}`, value)
  out = out.replace(/\{\{literal:([A-Z_]+)\}\}/g, '{{$1}}')
  return out.trim() + '\n'
}

function render(frontmatter, body, target, sourceFile) {
  const yaml = YAML.stringify(frontmatter, { lineWidth: 0 }).trimEnd()
  return `---\n${yaml}\n---\n\n${BANNER(sourceFile)}\n\n${renderBody(body, target)}`
}

/**
 * A skill targeting opencode is emitted as a global command. OpenCode has since gained
 * native Agent Skills (its `skill` tool), but this build keeps the command layout of
 * dist/opencode. Everything else maps one-to-one.
 */
function defaultEmit(kind, target) {
  if (kind === 'skills') return target === 'opencode' ? 'command' : 'skill'
  if (kind === 'commands') return 'command'
  return 'agent'
}

/**
 * Compute every generated file for one asset.
 * Returns [{ path, contents }] for rendered files and [{ path, copyFrom }] for verbatim copies.
 */
export function emit(asset) {
  const files = []
  const targets = asset.data.targets ?? []
  const harness = asset.data.harness ?? {}
  const { name, description } = asset.data

  for (const target of targets) {
    const cfg = harness[target] ?? {}
    if (cfg.skip) continue
    const extra = cfg.frontmatter ?? {}
    const emitAs = cfg.emit ?? defaultEmit(asset.kind, target)
    const outDir = {
      claude: join('plugins', CLAUDE_PLUGIN),
      opencode: join('dist', 'opencode'),
      copilot: join('dist', 'copilot'),
    }[target]

    if (emitAs === 'skill') {
      const dir = join(outDir, 'skills', name)
      files.push({
        path: join(dir, 'SKILL.md'),
        contents: render({ name, description, ...extra }, asset.body, target, asset.sourceFile),
      })
      for (const f of asset.extraFiles) files.push({ path: join(dir, f), copyFrom: join(asset.sourceDir, f) })
    } else if (emitAs === 'command') {
      const file =
        target === 'copilot'
          ? join(outDir, 'prompts', `${name}.prompt.md`)
          : join(outDir, target === 'claude' ? 'commands' : 'command', `${name}.md`)
      files.push({ path: file, contents: render({ description, ...extra }, asset.body, target, asset.sourceFile) })
    } else if (emitAs === 'agent') {
      const file =
        target === 'copilot'
          ? join(outDir, 'agents', `${name}.agent.md`)
          : join(outDir, target === 'claude' ? 'agents' : 'agent', `${name}.md`)
      const fm = target === 'opencode' ? { description, ...extra } : { name, description, ...extra }
      files.push({ path: file, contents: render(fm, asset.body, target, asset.sourceFile) })
    } else {
      throw new Error(`${asset.sourceFile}: unknown emit kind \`${emitAs}\` for target \`${target}\``)
    }
  }

  return files
}

function isMapping(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function isDir(p) {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}
